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

/**
 * 代表**兄弟筛选视图**的查询串键名。
 *
 * 放在 `lib/` 而不是 `App.tsx`：一级导航（`App.tsx`）与文件夹树
 * （`features/folders/FolderTree.tsx`）**必须用同一份**。两边各写一份的话，
 * 谁多一个键谁少一个键都不会报错，只会让某个地址上高亮 0 项或 2 项 ——
 * 而"至多一项"这条性质正是本模块存在的理由。
 *
 * ⚠️ 只有"代表另一个导航目标"的键才配进来。`tab` 是页内视图状态，**不在此列**：
 * 写进来就会让 `/models?tab=llm` 退回「一项都不亮」（T-138b 那个没人报得上来的哑巴 bug）。
 */
export const NAV_FILTER_KEYS = ['starred', 'folder'] as const;

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
 * @param filterKeys **指向兄弟筛选视图的查询串键名**（`['starred','folder']`）。
 *
 * 为什么需要显式声明这一个东西（T-138c）：
 * `?starred=1` 不用声明也认得出来 —— 侧栏条目里就摆着 `/notes?starred=1`，
 * 「这是个筛选视图」这件事从清单里就能看出来。
 * 但**文件夹是动态的**（`/notes?folder=<uid>`，`FolderTree` 拿着数据、数量随用户变），
 * 它们的 `to` 不可能出现在这张静态清单里。
 * 于是「`folder` 这个键代表一个筛选视图」就成了清单**看不出来**的那部分 —— 只能说出来。
 * 声明的是**键名**而不是具体地址：键名是稳定的，`uid` 不是。
 *
 * 不声明的后果很具体：在 `/notes?folder=<uid>` 上，`/notes` 会按「区域」赢下前缀匹配，
 * 于是「全部笔记」和那个文件夹**同时**被标成当前页 —— 正是 T-138b 刚修掉的那个形状。
 *
 * @returns 命中的 `to` 原样返回；一条都不该亮时返回 `undefined`
 *          （例如 `/capture` —— 它是侧栏顶部那个按钮，不是 SideLink；
 *          又如 `/notes?folder=x` —— 该亮的是文件夹树里那一条，不在这张清单里）。
 */
export function activeNavTarget(
  targets: readonly string[],
  location: { pathname: string; search: string },
  filterKeys: readonly string[] = [],
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
  /*
   * ★ 先问一句：当前地址是不是**某个兄弟筛选视图**？
   *
   * 是的话，区域就不该赢 —— 该亮的是那个筛选视图（可能在文件夹树里，不在这张清单上）。
   * 判据是"查询串里有没有 filterKeys 里的键"，**不是"有没有查询串"**：
   * `?tab=llm` 这类页内视图状态必须继续让区域亮着，
   * 否则就退回 `/models?tab=llm` **一项都不亮**的那个哑巴 bug（T-138b）。
   */
  const hasFilterKey = filterKeys.some((k) => new URLSearchParams(location.search).has(k));
  if (hasFilterKey) return undefined;

  let best: string | undefined;
  for (const to of targets) {
    if (to.includes('?')) continue;
    if (!isUnder(pathname, to)) continue;
    if (best === undefined || to.length > best.length) best = to;
  }
  return best;
}
