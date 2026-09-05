import type { ListNotesResponse } from '@openmemo/shared';

/**
 * 笔记列表缓存的**乐观更新规则** —— 纯函数（T-138 ③）。
 *
 * ## 为什么要单独抽出来
 *
 * 自本轮起「全部笔记」与「星标」是**两条不同的缓存**（筛选交给了
 * `GET /api/notes?starred=1`，不再由前端过滤）。于是"点一下星星，缓存该怎么变"
 * 多了一个此前不存在的分支：**星标那一页上取消星标，那条笔记就不属于这一页了。**
 *
 * 这条规则如果留在 `useMutation` 的 `onMutate` 里，只能靠"渲染组件 → 点击 →
 * 在 onSettled 的重取回来之前抢着断言"来验证 —— 一条依赖时序的用例，
 * 绿也说明不了什么，红也未必是产品坏了。本项目已经明确记过这笔账
 * （`components/app-shell/jobToastModel.ts` 的文件头写的就是同一件事）。
 *
 * 抽成纯函数之后，规则本身可以被逐条钉住，`onMutate` 只剩"对每条缓存调一次"。
 */
/**
 * 一页笔记 —— **就是 daemon 的响应本身**（`@openmemo/shared` 的 `ListNotesResponse`）。
 *
 * 不再是本地手写的 `{notes}`：T-157 ③ 之后响应带上了 `total`/`offset`/`hasMore`，
 * 而"前端自己再定义一份形状"正是本仓反复吃亏的那条缝
 * （`NoteSummary` / `NoteDetail` 都是这么收敛掉的）。
 */
export type NotesPage = ListNotesResponse;

/** `useInfiniteQuery` 的缓存形状（react-query 的 `InfiniteData`，这里只用得到 `pages`）。 */
export interface NotesPages {
  pages: NotesPage[];
  pageParams: unknown[];
}

/**
 * 把一次星标切换应用到**一页**笔记缓存上。
 *
 * @param filter queryKey 的第三段（`qk.notes.list(filter)` 里那个对象）。
 *               `{starred: true}` = 这一页是服务端按星标筛过的。
 *
 * ⚠️ 这里的过滤**不是"前端又筛了一遍"**：它是对"服务端下一次会返回什么"的预测，
 * 紧接着就被 `onSettled` 的 invalidate 纠正。筛选本身只有一个实现，在 daemon 的 SQL 里。
 */
export function applyStarToPage(
  page: NotesPage | undefined,
  filter: Record<string, unknown> | undefined,
  noteUid: string,
  starred: boolean,
): NotesPage | undefined {
  if (!page) return page;
  const starredPage = filter?.['starred'] === true;
  const notes = page.notes
    .map((n) => (n.uid === noteUid ? { ...n, starred } : n))
    .filter((n) => !starredPage || n.starred);
  /*
   * ★ T-157 ③：`total` 也要跟着动。
   *
   * 星标页上取消星标，那条笔记同时从**列表**和**总数**里消失 —— 只改列表的话，
   * 界面会在"只剩 2 条"的同时说"共 3 条 · 还有 1 条"，然后点「加载更多」拿回空数组。
   * 这与规则本身要预测的东西是同一件事：**服务端下一次会返回什么**，
   * 紧接着就被 `onSettled` 的 invalidate 纠正。
   */
  const removed = page.notes.length - notes.length;
  return { ...page, notes, total: Math.max(0, page.total - removed) };
}

/**
 * 把一次星标切换应用到**整份翻页缓存**上。
 *
 * `useInfiniteQuery` 的缓存是 `{pages: [...]}`；乐观更新必须打到**每一页**，
 * 否则用户翻到第二页之后点星星会一动不动 —— 这与 T-138 那次"只写 `list()` 那一条缓存"
 * 是同一个形状的疏漏，只是这次分叉在页与页之间。
 */
export function applyStarToPages(
  data: NotesPages | undefined,
  filter: Record<string, unknown> | undefined,
  noteUid: string,
  starred: boolean,
): NotesPages | undefined {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((p) => applyStarToPage(p, filter, noteUid, starred) as NotesPage),
  };
}
