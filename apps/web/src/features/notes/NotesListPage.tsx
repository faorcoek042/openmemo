import { Link, useNavigate, useSearchParams } from 'react-router';
import { arr } from '../../lib/safe';
import { useTranslation } from 'react-i18next';
import { FileAudio, Mic, Star } from 'lucide-react';

import { useNotesQuery, useToggleStarMutation } from './api';
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
  const [sp] = useSearchParams();
  const starredOnly = sp.get('starred') === '1';
  const { data: notes, isLoading, isError, error, refetch } = useNotesQuery({ starredOnly });
  const toggleStar = useToggleStarMutation();
  const visible = notes ?? [];

  if (isError) return <ErrorBlock error={error} onRetry={() => void refetch()} className="m-6" />;
  if (isLoading) return <div className="p-6 text-sm text-ink-muted">{t('common.loading')}</div>;

  if (visible.length === 0) {
    return (
      <EmptyState
        icon={starredOnly ? <Star className="size-10" /> : <FileAudio className="size-10" />}
        title={starredOnly ? t('notes.starredEmpty') : t('notes.empty')}
        hint={starredOnly ? t('notes.starredEmptyHint') : t('notes.emptyHint')}
        // 空态即入口：直接把下一步动作放眼前，而不是只说"暂无数据"
        // 星标空态的下一步不是"新建捕获"（他已经有笔记了），是"回去挑一条加星"
        action={
          starredOnly ? (
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
        {starredOnly ? t('nav.starred') : t('notes.title')}
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
                    {n.source?.site ? <span>{n.source.site}</span> : null}
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
    </div>
  );
}
