import { useNavigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Search as SearchIcon } from 'lucide-react';

import { useSearchQuery, type SearchMode } from './api';
import { EmptyState } from '../../components/common/EmptyState';
import { ErrorBlock } from '../../components/common/ErrorBlock';
import { MockNotice } from '../../components/common/MockNotice';
import { timecode } from '../../lib/format/time';
import { cn } from '../../lib/utils';

const MODES: SearchMode[] = ['hybrid', 'keyword', 'semantic'];

/**
 * F5 全局搜索（章程明确要求"搜索"）。
 *
 * ## 这一页的关键体验：**结果直达时间点**
 *
 * 命中的是转写段落时，结果带 `startMs` —— 点一下不是"打开这篇笔记"，
 * 而是**打开并跳到那一秒**。这是 D-05 §4.4 说的杀手级体验，
 * 也是"转写稿 ↔ 时间轴"数据结构的最终检验：如果搜索结果跳不到那一秒，
 * 说明时间轴模型没设计对。
 *
 * 三档模式对应 D-02 §4.4：关键词（FTS5 bm25 + 中文分词）/ 语义（sqlite-vec）/
 * 混合（RRF 融合）。向量索引不可用时服务端会降级，UI 相应隐藏后两档。
 */
export default function SearchPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const mode = (params.get('mode') as SearchMode) ?? 'hybrid';

  const { data: hits, isLoading, isError, error, refetch } = useSearchQuery(q, mode);

  const setQ = (next: string) => {
    setParams((p) => {
      if (next) p.set('q', next);
      else p.delete('q');
      return p;
    });
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-8">
      <h1 className="text-xl font-semibold text-ink">{t('search.title')}</h1>

      <div className="relative">
        <SearchIcon className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-muted" aria-hidden />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('search.placeholder')}
          aria-label={t('search.title')}
          autoFocus
          className="h-10 w-full rounded-md border border-line bg-surface-1 pr-3 pl-9 text-sm text-ink placeholder:text-ink-muted"
        />
      </div>

      <div className="flex gap-1" role="tablist" aria-label={t('search.mode')}>
        {MODES.map((m) => (
          <button
            key={m}
            role="tab"
            aria-selected={mode === m}
            onClick={() =>
              setParams((p) => {
                p.set('mode', m);
                return p;
              })
            }
            className={cn(
              'rounded-md px-2.5 py-1 text-xs transition-colors',
              mode === m ? 'bg-accent text-accent-fg' : 'text-ink-secondary hover:bg-fill-hover',
            )}
          >
            {t(`search.modes.${m}`)}
          </button>
        ))}
      </div>

      <MockNotice surface="notes" />

      {isError ? <ErrorBlock error={error} onRetry={() => void refetch()} /> : null}

      {!q.trim() ? (
        <EmptyState title={t('search.idle')} hint={t('search.idleHint')} />
      ) : isLoading ? (
        <p className="text-sm text-ink-muted">{t('common.loading')}</p>
      ) : !hits || hits.length === 0 ? (
        <EmptyState title={t('search.noResults')} hint={t('search.noResultsHint')} />
      ) : (
        <ul className="flex flex-col gap-2" role="list">
          {hits.map((h, i) => (
            <li key={`${h.noteUid}-${h.startMs ?? i}`}>
              <button
                type="button"
                onClick={() =>
                  // ★ 直达时间点：带上 ?t=<ms>，详情页据此 seek
                  navigate(
                    h.startMs != null
                      ? `/notes/${h.noteUid}?t=${h.startMs}`
                      : `/notes/${h.noteUid}`,
                  )
                }
                className="w-full rounded-lg border border-line bg-surface-1 p-3 text-left transition-colors hover:bg-fill-hover"
              >
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-sm font-medium text-ink">{h.noteTitle}</span>
                  {h.startMs != null ? (
                    <span className="shrink-0 tabular-nums text-xs text-accent-ink">
                      {timecode(h.startMs)}
                    </span>
                  ) : null}
                </div>
                {/* snippet 由服务端 simple_highlight 产出，含 <mark> 标签。
                    这里是**受控的服务端输出**，不是用户输入，故可安全渲染。 */}
                <p
                  className="mt-1 text-sm text-ink-secondary [&_mark]:bg-accent-tint [&_mark]:text-ink"
                  dangerouslySetInnerHTML={{ __html: h.snippet }}
                />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
