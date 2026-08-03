import type { NoteSummary } from './types';

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
 * （`components/common/jobToastModel.ts` 的文件头写的就是同一件事）。
 *
 * 抽成纯函数之后，规则本身可以被逐条钉住，`onMutate` 只剩"对每条缓存调一次"。
 */
export interface NotesPage {
  notes: NoteSummary[];
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
  return { notes };
}
