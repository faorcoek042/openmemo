import { Link, useNavigate, useSearchParams } from 'react-router';
import { arr } from '../../lib/safe';
import { useTranslation } from 'react-i18next';
import { FileAudio, Mic, Star } from 'lucide-react';

import { flattenNotes, useNotesQuery, useToggleStarMutation } from './api';
// 跨 feature 只走门面（`../folders`，不是 `../folders/api`）—— eslint 的分层护栏放行的正是这一种
import { flattenFolders, useFoldersQuery } from '../folders';
import { EmptyState } from '../../components/common/EmptyState';
import { MockNotice } from '../../components/common/MockNotice';
import { ErrorBlock } from '../../components/common/ErrorBlock';
import { StatusChip } from '../../components/common/StatusChip';
import { Button } from '../../components/common/Button';
import { NoteProgressLine } from './NoteProgressLine';
import { humanDuration, relativeTime } from '../../lib/format/time';
import { cn } from '../../lib/utils';

/** F5 笔记列表。 */
export default function NotesListPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();

  /*
   * ★ 侧栏「星标」= `/notes?starred=1`，与「全部笔记」**共用这一个组件**。
   *
   * 在这之前这个组件**从不读查询串** —— 点「星标」和点「全部笔记」渲染的是同一批笔记，
   * 标题也一样写着「全部笔记」（`ui-polish` 在 T-124 的真浏览器截图里抓到，`[实测]`）。
   * 它和「两项永远同时高亮」是同一个疏漏的两半：那半是**导航层**没认查询串，
   * 这半是**数据层**没认。**这一页的状态来源是 URL，导航高亮与列表内容都得认它。**
   *
   * ✅ **T-138 ③：筛选已经挪进端点了。**
   * T-129 那版在前端对已取回的一页做 `filter(n => n.starred)`，并在这里写着
   * 「真正的修法是端点支持 starred」—— 那句话现在可以删掉了：
   * `GET /api/notes?starred=1` 在 SQL 的 WHERE 里筛（`db/repos.ts:listNotes`），
   * `limit=50` 限的是**星标笔记**的条数，笔记总数超过 50 条也不会再无声地漏。
   *
   * ⚠️ 前端那层 `.filter()` 是**故意删掉的，不是忘了**。留着它，
   * 端点哪天回退成"不认这个参数"，页面看起来照样正确 —— 于是护栏测的是前端那层，
   * 真正的筛选在哪没人知道。删掉之后，查询串是**唯一**的筛选依据，
   * 端点坏了页面就会立刻显形（组件测试断的正是"请求带上了 ?starred=1"）。
   */
  /*
   * ★ T-138 ④：`?folder=` 也是这一页的状态来源，和 `starred` 同类。
   *
   * 在这之前**全仓没有一处读它** —— 点开一个空文件夹，地址变了、侧栏高亮变了，
   * 页面照常列出全部笔记。T-138c 把侧栏高亮修准之后这件事反而更糟：
   * 界面开始用一种可信的口气说「你在『课程』里」，同时列出所有笔记。
   * **修复提高了谎言的可信度** —— 所以这里必须一起接上，不能只修高亮。
   *
   * 筛选按裁决**含子孙**，递归在 daemon 的 SQL 里；侧栏那个计数与这里的返回
   * 走的是同一份闭包定义（`repos.ts` 的 `FOLDER_CLOSURE_CTE`），不许一个含子孙一个不含。
   */
  /*
   * ★ T-157 ③：翻页。
   *
   * 在这之前列表**恒定只有前 50 条**（端点默认 limit=50、无 offset，前端连 limit 都不传）：
   * 第 51 条起在界面上永远不存在，没有翻页、没有总数、没有任何提示。
   * 「显示得不全且不说」与「显示错的」在用户那里是同一件事 ——
   * 这句话上面 `starred` 那段已经写过一遍，只是当时没有人把它套到**总量**上。
   *
   * 判据是「要么真的能翻到第 51 条，要么明确告诉用户还有更多」。
   * 下面两样都给：底部常驻一行 `已显示 M / N 条`，还有更多时给一个真的会拉下一页的按钮。
   */
  const [sp] = useSearchParams();
  const starredOnly = sp.get('starred') === '1';
  const folderUid = sp.get('folder') ?? undefined;
  const {
    data,
    isLoading,
    isError,
    error,
    refetch,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useNotesQuery({
    starredOnly,
    ...(folderUid ? { folderUid } : {}),
  });
  const notes = flattenNotes(data?.pages);
  // 总数取**最后一页**的：翻页期间前面几页的 total 是旧快照，用第一页会在有人新建笔记后长期偏小
  const total = data?.pages.at(-1)?.total ?? notes.length;
  const folders = useFoldersQuery();
  const folderName = folderUid
    ? (flattenFolders(folders.data).find((f) => f.uid === folderUid)?.name ?? null)
    : null;
  const toggleStar = useToggleStarMutation();
  const visible = notes ?? [];

  if (isError) return <ErrorBlock error={error} onRetry={() => void refetch()} className="m-6" />;
  if (isLoading) return <div className="p-6 text-sm text-ink-muted">{t('common.loading')}</div>;

  if (visible.length === 0) {
    return (
      <EmptyState
        icon={starredOnly ? <Star className="size-10" /> : <FileAudio className="size-10" />}
        title={
          folderUid
            ? t('notes.folderEmpty', { name: folderName ?? '' })
            : starredOnly
              ? t('notes.starredEmpty')
              : t('notes.empty')
        }
        hint={
          folderUid
            ? t('notes.folderEmptyHint')
            : starredOnly
              ? t('notes.starredEmptyHint')
              : t('notes.emptyHint')
        }
        // 空态即入口：直接把下一步动作放眼前，而不是只说"暂无数据"
        // 星标/文件夹空态的下一步不是"新建捕获"（他已经有笔记了），是"回到全部笔记"
        action={
          starredOnly || folderUid ? (
            <Button variant="secondary" onClick={() => navigate('/notes')}>
              {t('notes.title')}
            </Button>
          ) : (
            <Button variant="primary" onClick={() => navigate('/capture')}>
              {t('nav.newCapture')}
            </Button>
          )
        }
      />
    );
  }

  return (
    <div className="px-6 py-6">
      <h1 className="mb-4 text-xl font-semibold text-ink" data-testid="notes-list-title">
        {/*
          标题也得跟着筛选走。在文件夹里却顶着「全部笔记」，
          与"高亮说你在课程里、内容却是全部"是同一种谎 —— 只是换了个位置。
          文件夹名还没拉回来时退到「文件夹」而不是「全部笔记」：宁可笼统，不可说错。
        */}
        {folderUid
          ? (folderName ?? t('nav.folders'))
          : starredOnly
            ? t('nav.starred')
            : t('notes.title')}
      </h1>
      <MockNotice surface="notes" className="mb-3" />
      <ul className="flex flex-col gap-2" role="list" data-testid="notes-list">
        {visible.map((n) => (
          <li key={n.uid}>
            <Link
              to={`/notes/${n.uid}`}
              className="block rounded-lg border border-line bg-surface-1 p-3 transition-colors hover:bg-fill-hover"
            >
              <div className="flex items-start gap-3">
                <div className="mt-0.5 text-ink-muted" aria-hidden>
                  {n.kind === 'recording' ? <Mic className="size-4" /> : <FileAudio className="size-4" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate text-sm font-medium text-ink">{n.title || t('notes.untitled')}</h2>
                    {/* 星标此前只显示不能点 —— 现在是真的写入路径（乐观更新） */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        toggleStar.mutate({ noteUid: n.uid, starred: !n.starred });
                      }}
                      aria-label={n.starred ? t('notes.unstar') : t('notes.star')}
                      aria-pressed={n.starred}
                      className="shrink-0 rounded p-0.5 hover:bg-fill-hover"
                    >
                      <Star
                        className={cn(
                          'size-3.5',
                          n.starred ? 'fill-current text-warning' : 'text-ink-muted',
                        )}
                        aria-hidden
                      />
                    </button>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
                    {n.durationMs ? <span>{humanDuration(n.durationMs, i18n.language)}</span> : null}
                    {/*
                      ⚠️ 这里原来有一个站点徽章 `{n.source?.site ? <span>{n.source.site}</span> : null}`。
                      **删掉了，不是改名**（T-150）：`GET /api/notes` 的 `.map()` 从来不发 `source`
                      —— 全仓唯一提供它的是 `lib/api/mock.ts`。于是这个徽章
                      **在真实环境里一次都没渲染过**，只是因为用了可选链所以不崩。
                      与 `n.activeJobId`（见下面那条）、与 `<audio>` 从未进过 DOM（T-139 A1）
                      是同一族：**mock 的形状比真响应宽**。

                      没有"把它补进 daemon 的响应"，是因为列表页要的是"这条是从哪来的"，
                      而那个事实在详情页已经有出处；给列表端点再加一份就是第二个出处。
                      真要在列表上显示来源，正确做法是先在 `NoteListItem` 契约里加字段
                      （加了这里就会编译报错提醒有人来渲染它），而不是先在界面上摆一个空位。
                    */}
                    <span>{relativeTime(Date.parse(n.updatedAt), i18n.language)}</span>
                    {arr(n.tags).map((tag) => (
                      <span key={tag.uid} className="rounded bg-surface-0 px-1.5 py-0.5 text-ink-secondary">
                        {tag.name}
                      </span>
                    ))}
                  </div>
                  {/*
                    未完成的任务在列表里也要能看到进度 —— 进度来自 jobs，与页面无关。
                    条件不再由这里判断：`n.activeJobId` 是一个 daemon 从未返回过的字段，
                    这一行因此**在真实环境里从来没渲染过**（T-138 ②）。
                  */}
                  <NoteProgressLine noteUid={n.uid} className="mt-2" />
                </div>
                <div className="shrink-0">
                  {n.status === 'processing' ? (
                    <StatusChip tone="running" label={t('notes.processing')} />
                  ) : n.status === 'failed' ? (
                    <StatusChip tone="critical" label={t('notes.failed')} />
                  ) : n.status === 'partial' ? (
                    <StatusChip tone="warning" label={t('notes.partial')} />
                  ) : null}
                </div>
              </div>
            </Link>
          </li>
        ))}
      </ul>

      {/*
        ★ 这一块**永远渲染**，不是"只有还有更多时才出现"。
        只在 hasMore 时才说话的话，用户在"刚好一页"和"全部"之间分不出来 ——
        而分不出来正是这条缺陷的本体：页面从不说自己给全了没有。
      */}
      <div className="mt-4 flex items-center justify-center gap-3" data-testid="notes-list-footer">
        <span className="text-xs text-ink-muted" data-testid="notes-list-count">
          {hasNextPage
            ? t('notes.shownOfTotal', { shown: visible.length, total })
            : t('notes.allLoaded', { total })}
        </span>
        {hasNextPage ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={isFetchingNextPage}
            onClick={() => void fetchNextPage()}
            data-testid="notes-load-more"
          >
            {isFetchingNextPage ? t('notes.loadingMore') : t('notes.loadMore')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
