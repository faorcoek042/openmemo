import { useNavigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Search as SearchIcon } from 'lucide-react';

import { useSearchModesQuery, useSearchQuery } from './api';
import { availableModes, effectiveMode, missingModes } from './modes';
import { EmptyState } from '../../components/common/EmptyState';
import { ErrorBlock } from '../../components/common/ErrorBlock';
import { MockNotice } from '../../components/common/MockNotice';
import { timecode } from '../../lib/format/time';
import { cn } from '../../lib/utils';

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
 * ## 档位由**服务端**说了算（T-164 ⑤）
 *
 * D-02 §4.4 设计的是三档：关键词（FTS5 bm25 + 中文分词）/ 语义（sqlite-vec）/
 * 混合（RRF 融合）。这里原来的注释写着「向量不可用时…UI 相应隐藏后两档」——
 * **那段隐藏逻辑从来不存在**：`MODES` 是写死常量、恒渲染三个 tab、默认 `hybrid`，
 * 而 `rest/search.ts` 从头到尾不读 `mode`。用户切档、以为换了检索方式，
 * 三档返回同一份关键词结果，界面一个字都不说。
 *
 * 现在：档位来自 `/api/search` 响应里的 `modes`，只渲染服务端**真的提供**的那几档；
 * 只剩一档时不渲染选择器（没有什么可选的）；缺的那几档把服务端给的原因如实说出来。
 */
export default function SearchPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';

  /*
   * 档位要在用户**打字之前**就定下来 —— 否则空查询时三个 tab 全摆出来，
   * 点完一个再让它消失，比一直不显示更糟。
   */
  const probe = useSearchModesQuery();
  const search = useSearchQuery(q, effectiveMode(params.get('mode'), probe.data));
  const { isLoading, isError, error, refetch } = search;
  const hits = search.data?.hits;
  // 有结果时用这次响应里的 modes（最新），否则用探测那一份
  const modes = search.data?.modes ?? probe.data;
  const shown = availableModes(modes);
  const mode = effectiveMode(params.get('mode'), modes);
  const missing = missingModes(modes);

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

      {/* 只有一档时不渲染选择器 —— 一个"选择器"里只有一个选项，是在暗示还有别的 */}
      {shown.length > 1 ? (
        <div className="flex gap-1" role="tablist" aria-label={t('search.mode')}>
          {shown.map((m) => (
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
      ) : null}

      {/*
        缺的那几档：**说出来，并且用服务端给的原话**。
        不说的话用户只会以为这个产品没设计过语义检索；
        自己编一句理由则是把一个真实的限制换成一句想象 —— 那正是这条要修的病。
      */}
      {missing.length > 0 && modes ? (
        <p className="text-xs text-ink-muted" data-testid="search-modes-unavailable">
          {t('search.modesUnavailable', {
            modes: missing.map((m) => t(`search.modes.${m}`)).join(' / '),
            reason: modes.semanticReason ?? t('search.modesUnavailableUnknown'),
          })}
        </p>
      ) : null}

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
