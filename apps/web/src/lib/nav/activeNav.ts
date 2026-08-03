/**
 * 侧栏「哪一项该高亮」—— 纯决策（T-138b）。
 *
 * ## 这条规则为什么不能靠 `NavLink` 自己
 *
 * `NavLink` 的 `isActive` **只比 pathname，按段前缀匹配**。侧栏里有两项共用一个 pathname
 * （「全部笔记」`/notes`、「星标」`/notes?starred=1`），于是它俩永远一起亮。
 * T-124 之前选中态是 `bg-surface-2`（对侧栏底 1.02:1，肉眼看不见），没人发现；
 * 换成品牌淡底之后立刻刺眼。
 *
 * ## 上一版的判据只覆盖了列表页 —— 它有**两个**方向相反的失败面
 *
 * 上一版是「pathname 相同就精确比查询串，否则交回 NavLink」。实测（逐个地址枚举）：
 *
 * | 地址 | 高亮项数 | 症状 |
 * |---|---|---|
 * | `/notes/01KZ…?tab=mindmap` | **2** | 详情页是 `/notes` 的**子路径**，`pathname === linkPath` 不成立 → 交回前缀匹配 → 两项一起亮 |
 * | `/models?tab=llm` | **0** | pathname 相同、查询串不同 → 精确比对判否 → 「模型」自己**灭了** |
 *
 * 两个症状，一个成因：**它问的是"地址一样吗"，而该问的是"这个地址归谁管"。**
 *
 * ## 什么时候该用前缀、什么时候该用精确
 *
 * 判据不在"有没有查询串"，在**这个查询串是不是某个导航目标本身的一部分**：
 *
 * - **带查询串的条目 = 集合的一个「筛选视图」**（`/notes?starred=1`）。
 *   筛选**不向下延伸到成员**：`/notes/<uid>` 不在"星标视图"里 ——
 *   那条笔记加没加星不一定，用户也可能是从「全部笔记」点进去的。
 *   → 只在**地址完全相同**时高亮。
 * - **不带查询串的条目 = 一个「区域」**（`/settings`、`/models`、`/notes`）。
 *   区域**管辖自己的子路径**：`/settings/storage`、`/models/:id`、`/notes/:uid` 都算在它头上。
 *   → 前缀匹配（按段边界）。
 * - **不属于任何导航目标的查询串 = 页内视图状态**，不是导航（`?tab=llm`、`?tab=mindmap`）。
 *   → **一律不参与判定**。这正是 `/models?tab=llm` 那盏灯灭掉的原因。
 *
 * ## 为什么返回"哪一个"而不是逐项判"是不是"
 *
 * 真正要守的性质是**至多有一项高亮**。逐项独立判断时，这条性质没有任何地方在管它 ——
 * 它只是"每项各自判对了"的一个巧合，而上面那张表说明巧合会破。
 * 让这个函数返回**一个** target，该性质就由类型保证，不再需要谁记得。
 */

/** 段边界前缀：`/notes` 管辖 `/notes/x`，但**不**管辖 `/notesomething`。 */
function isUnder(pathname: string, base: string): boolean {
  if (pathname === base) return true;
  return pathname.startsWith(base.endsWith('/') ? base : `${base}/`);
}

/**
 * 查询串归一化：排序后逐对比较。
 * `?a=1&b=2` 与 `?b=2&a=1` 是同一个地址，字符串直比会判成两个。
 */
function normalizeQuery(raw: string): string {
  const sp = new URLSearchParams(raw.replace(/^\?/, ''));
  return [...sp.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/**
 * 从「侧栏全部条目 + 当前地址」算出**唯一**该高亮的那一条。
 *
 * @param targets `SideLink` 的 `to` 全集，顺序无关。
 * @returns 命中的 `to` 原样返回；一条都不该亮时返回 `undefined`
 *          （例如 `/capture` —— 它是侧栏顶部那个按钮，不是 SideLink）。
 */
export function activeNavTarget(
  targets: readonly string[],
  location: { pathname: string; search: string },
): string | undefined {
  const pathname = location.pathname;
  const query = normalizeQuery(location.search);

  // ① 地址完全命中 —— 筛选视图只认这一种
  for (const to of targets) {
    const [p = '', q = ''] = to.split('?');
    if (p === pathname && normalizeQuery(q) === query) return to;
  }

  /*
   * ② 否则交给「区域」：管辖范围覆盖当前 pathname 的、**路径最长**的那个不带查询串的条目。
   *
   * 取最长而不是取第一个：将来若同时存在 `/settings` 与 `/settings/advanced` 两个侧栏项，
   * 在 `/settings/advanced/x` 上必须是后者亮。写第一个匹配就会依赖数组顺序 ——
   * 一条只有改了顺序才会坏、且坏了不报错的规则。
   */
  let best: string | undefined;
  for (const to of targets) {
    if (to.includes('?')) continue;
    if (!isUnder(pathname, to)) continue;
    if (best === undefined || to.length > best.length) best = to;
  }
  return best;
}
